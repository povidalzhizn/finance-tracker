// node --test test/  — движок и настоящий Code.gs на выдуманных данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../app/engine.js';
import { RULES, seed } from '../tools/seed.mjs';
import { makeGoogle, TOKEN } from '../tools/fake-google.mjs';

const E = globalThis.FinEngine, rules = E.parseRules(RULES);
const HEAD = '"Дата операции";"Сумма операции";"Статус";"Категория по-умолчанию";"MCC";"Описание";"Учёт в аналитике"';
const line = (dt, sum, st, cat, mcc, desc, inA = 'Да') => [dt, sum, st, cat, mcc, desc, inA].map(x => `"${x}"`).join(';');
const tb = (...l) => E.parseTbank('﻿' + [HEAD, ...l].join('\n'));
const op = (o = {}) => Object.assign({ bank: 'Т-Банк', date: '2026-10-14', time: '19:00', stamp: '19:00:00', amount: -100, desc: '', bcat: '', mcc: '', status: 'Ок', counted: true, key: Math.random() + '' }, o);

test('Т-Банк: разбор CSV', () => {
  const [o] = tb(line('01.11.2026 22:24:59', '-1 194,98', 'Ок', 'Супермаркеты', '5411', 'Лента'));
  assert.equal(o.date, '2026-11-01'); assert.equal(o.time, '22:24'); assert.equal(o.amount, -1194.98); assert.equal(o.desc, 'Лента');
  assert.throws(() => E.parseTbank('a;b\n1;2'), /не выписка/);
});

test('Сбер: строка собирается по координатам, сверка с шапкой', () => {
  const page = [
    { x: 349, y: 673, s: 'Пополнение' }, { x: 521, y: 673, s: '5 000,00' }, { x: 349, y: 659, s: 'Списание' }, { x: 521, y: 659, s: '915,00' },
    { x: 45, y: 487, s: '01.11.2026' }, { x: 102, y: 487, s: '15:45' }, { x: 152, y: 487, s: 'Рестораны и кафе' }, { x: 437, y: 487, s: '915,00' }, { x: 535, y: 487, s: '140,28' },
    { x: 45, y: 476, s: '01.11.2026' }, { x: 102, y: 476, s: '911849' }, { x: 152, y: 476, s: 'SOME CAFE SANKT-PETERBU RUS. Операция по' },
    { x: 152, y: 466, s: 'карте ****0000' },
    { x: 45, y: 449, s: '31.10.2026' }, { x: 102, y: 449, s: '11:08' }, { x: 152, y: 449, s: 'Внесение наличных' }, { x: 427, y: 449, s: '+5 000,00' }, { x: 529, y: 449, s: '1 055,28' },
    { x: 45, y: 438, s: '31.10.2026' }, { x: 102, y: 438, s: '734459' }, { x: 152, y: 438, s: 'Банкомат №600. Операция по карте ****0000' },
  ];
  const ops = E.parseSber([page]);
  assert.deepEqual(ops.map(o => [o.date, o.amount, o.bcat, o.desc]), [
    ['2026-11-01', -915, 'Рестораны и кафе', 'SOME CAFE SANKT-PETERBU RUS.'], ['2026-10-31', 5000, 'Внесение наличных', 'Банкомат №600.']]);
  page[1].s = '6 000,00';
  assert.throws(() => E.parseSber([page]), /не сошлась/);
});

test('Лист правил: условия и служебные строки', () => {
  assert.ok(!rules.some(r => r.patterns.includes('сумма')), 'блок «Общие правила» не правило');
  const c = (o) => E.classify(op(o), rules);
  assert.equal(c({ desc: 'Красное и белое', amount: -199 }).cat, 'Продукты');
  assert.equal(c({ desc: 'Красное и белое', amount: -200 }).cat, 'Развлечения');
  assert.equal(c({ desc: 'Анна Т.', bcat: 'Переводы', amount: -40000 }).cat, 'Жильё и коммуналка');
  assert.equal(c({ desc: 'Анна Т.', bcat: 'Переводы', amount: 500 }).layer, 'ask', 'входящий от неё — вопрос');
  assert.equal(c({ desc: 'Pure.', bank: 'Сбер', bcat: 'Оплата по QR–коду СБП' }).cat, 'Развлечения');
  assert.equal(c({ desc: 'METRO TPP SANKT-PETERBU RUS.', bank: 'Сбер' }).cat, 'Транспорт');
  assert.equal(c({ desc: 'Moskovskaya-2', bank: 'Сбер' }).cat, 'Транспорт');
  assert.equal(c({ desc: 'Т-Банк.', bank: 'Сбер', bcat: 'Перевод СБП', amount: 500 }).layer, 'skip');
  assert.equal(c({ desc: 'LENTA', bank: 'Т-Банк' }).layer, 'ask', 'правило другого банка не срабатывает');
});

test('Кредитка: мелкая сумма — самокат, крупная — вопрос с подсказкой', () => {
  const small = E.classify(op({ bank: 'Сбер', bcat: 'Перевод с карты', desc: 'SBOL.', amount: -131 }), rules);
  assert.equal(small.cat, 'Транспорт');
  const big = E.classify(op({ bank: 'Сбер', bcat: 'Перевод с карты', desc: 'SBOL.', amount: -21000 }), rules);
  assert.equal(big.layer, 'ask'); assert.match(big.note, /кредиткой/);
});

test('Обед: будни днём меняют категорию, вечер и выходные нет', () => {
  const v = o => E.classify(op(Object.assign({ desc: 'ВкусВилл' }, o)), rules);
  assert.deepEqual([v({ time: '13:39' }).cat, v({ time: '13:39' }).comment], ['Кафе и рестораны', 'Обед']);
  assert.equal(v({ time: '19:30' }).cat, 'Продукты');
  assert.equal(v({ date: '2026-10-17', time: '13:39' }).cat, 'Продукты', 'суббота');
});

test('Слои: ошибка банка, свои переводы, догадка, вопрос', () => {
  assert.equal(E.classify(op({ status: 'Ошибка', desc: 'Лента' }), rules).why, 'failed');
  assert.equal(E.classify(op({ counted: false, desc: 'Лента' }), rules).why, 'own');
  const g = E.classify(op({ desc: 'Новый магазин 12', bcat: 'Супермаркеты' }), rules);
  assert.deepEqual([g.layer, g.cat, g.comment], ['guess', 'Продукты', 'Новый магазин']);
  assert.equal(E.classify(op({ desc: 'Случайный сервис', bcat: 'Сервисы' }), rules).layer, 'ask');
  assert.equal(E.classify(op({ desc: 'Иван И.', bcat: 'Переводы' }), rules).layer, 'ask', 'перевод человеку не угадываем');
  assert.equal(E.classify(op({ desc: 'Магазин', bcat: 'Супермаркеты', amount: 100 }), rules).layer, 'ask', 'возврат не угадываем');
});

test('План импорта: дубли, ручные записи, повторная загрузка, граница', () => {
  const rows = [
    { date: '2026-10-14', type: 'Расход', cat: 'Продукты', sum: 450, comment: 'Лента', account: 'Т-Банк' },
    { date: '2026-10-15', type: 'Расход', cat: 'Продукты', sum: 300, comment: 'Лента', account: '' },
  ];
  const a = op({ desc: 'Лента', amount: -449.9 }), b = op({ desc: 'Лента', amount: -449.9, stamp: '20:00:00' });
  const c = op({ date: '2026-10-15', desc: 'Лента', amount: -303.5 }), old = op({ date: '2026-10-01', desc: 'Лента' });
  const p = E.planImport({ ops: [a, b, c, old], rules, rows, seen: new Set(), cutoffs: { 'Т-Банк': '2026-10-10' } });
  assert.equal(p.counts.dup, 2, 'один к одному: вторая такая же покупка не считается дублем');
  assert.equal(p.add.length, 1); assert.equal(p.counts.old, 1);
  assert.equal(p.fill.length, 1); assert.equal(p.fill[0].row.account, 'Т-Банк'); assert.equal(p.fill[0].row.sum, 300, 'сумму ручной записи не трогаем');
  const again = E.planImport({ ops: [a], rules, rows: [], seen: new Set([a.key]), cutoffs: {} });
  assert.equal(again.counts.again, 1); assert.equal(again.add.length, 0);
});

test('Ответ превращается в правило, которое ловит следующую операцию', () => {
  const o = op({ bank: 'Сбер', desc: 'DNS RETAIL 44 SANKT-PETERBU RUS.', bcat: 'Электроника' });
  const row = E.ruleRow(o, { type: 'Расход', cat: 'Прочие расходы', comment: 'DNS' });
  assert.deepEqual(row, ['DNS RETAIL', 'Сбер', 'Расход', 'Прочие расходы', 'DNS', '']);
  const next = E.classify(op({ bank: 'Сбер', desc: 'DNS RETAIL 45 MOSKVA RUS.', amount: -7 }), E.parseRules([...RULES.slice(0, 3), row]));
  assert.deepEqual([next.layer, next.cat], ['rule', 'Прочие расходы']);
  assert.deepEqual(E.ruleRow(op({ desc: 'Иван И.', bcat: 'Переводы', amount: 500 }), { skip: true }), ['Иван И.', 'Т-Банк', 'не вносить', '', '', 'входящий перевод']);
});

test('Сводка: «Не учитывать» не входит в доходы', () => {
  const m = E.months([
    { date: '2026-10-01', type: 'Доход', cat: 'A', sum: 100 }, { date: '2026-10-02', type: 'Не учитывать', cat: 'A', sum: 999 },
    { date: '2026-10-03', type: 'Расход', cat: 'B', sum: 40 }, { date: '2026-09-03', type: 'Расход', cat: 'B', sum: 10 }]);
  assert.deepEqual(m.map(x => [x.month, x.income, x.expense]), [['2026-09', 0, 10], ['2026-10', 100, 40]]);
});

/* ---------- Code.gs ---------- */
const client = () => {
  const g = makeGoogle(seed()), call = (action, p) => JSON.parse(g.call({ action, token: TOKEN, ...p }));
  return { g, call };
};
const row = { date: '2026-05-03', type: 'Расход', cat: 'Подарки', sum: 1234.5, comment: 'Тест', account: 'Наличные' };

test('Скрипт: чужой токен не проходит', () => {
  const { g } = client();
  assert.match(JSON.parse(g.call({ action: 'pull', token: 'x' })).error, /токен/);
});

test('Скрипт: чтение, граница по счетам, служебные строки правил', () => {
  const { call } = client(), r = call('pull');
  assert.ok(r.rows.length > 100); assert.equal(r.rows[0].date.length, 10);
  assert.deepEqual(r.cats.income.slice(0, 2), ['Зарплата', 'Фриланс и проекты']);
  assert.equal(r.cats.expense.at(-1), 'Прочие расходы');
  assert.equal(r.cutoffs['Т-Банк'], '2026-11-01');
  assert.equal(r.seen.length, 0);
});

test('Скрипт: добавление с сортировкой, повтор запроса не задваивает', () => {
  const { call } = client(), before = call('pull').rows.length, actions = [{ id: 'k1', kind: 'add', row, date: row.date }];
  call('apply', { actions });
  const again = call('apply', { actions });
  assert.equal(again.results[0].again, true);
  const r = call('pull');
  assert.equal(r.rows.length, before + 1);
  assert.deepEqual(r.rows.map(x => x.date), r.rows.map(x => x.date).slice().sort(), 'лист отсортирован');
  assert.ok(r.rows.some(x => x.comment === 'Тест' && x.sum === 1234.5 && x.date === '2026-05-03'));
  assert.ok(r.seen.includes('k1'));
});

test('Скрипт: правка и удаление по содержимому, устаревшая строка не ломает очередь', () => {
  const { call } = client();
  call('apply', { actions: [{ id: 'a', kind: 'add', row }] });
  const edited = { ...row, cat: 'Спорт' };
  const res = call('apply', { actions: [
    { id: 'b', kind: 'update', old: row, row: edited },
    { id: 'c', kind: 'update', old: row, row: edited },
    { id: 'd', kind: 'add', row: { ...row, comment: 'После ошибки' } }] });
  assert.deepEqual(res.results.map(x => x.ok), [true, false, true]);
  let rows = call('pull').rows;
  assert.ok(rows.some(x => x.comment === 'Тест' && x.cat === 'Спорт'));
  const n = rows.length;
  call('apply', { actions: [{ id: 'e', kind: 'delete', old: edited }] });
  rows = call('pull').rows;
  assert.equal(rows.length, n - 1); assert.ok(!rows.some(x => x.comment === 'Тест'));
});

test('Скрипт: добавление и правка в одном запросе попадают в нужные строки', () => {
  const { call } = client(), first = call('pull').rows[0];
  const res = call('apply', { actions: [
    { id: 'x1', kind: 'add', row },
    { id: 'x2', kind: 'delete', old: first },
    { id: 'x3', kind: 'update', old: row, row: { ...row, comment: 'Новое' } }] });
  assert.ok(res.results.every(x => x.ok));
  const rows = call('pull').rows;
  assert.ok(rows.some(x => x.comment === 'Новое')); assert.ok(!rows.some(x => x.comment === 'Тест'));
});

test('Скрипт: новое правило встаёт над пустой строкой перед «Общие правила»', () => {
  const { call, g } = client();
  call('apply', { actions: [{ id: 'r1', kind: 'rule', rule: ['DNS', 'Т-Банк', 'Расход', 'Прочие расходы', 'DNS', ''] }, { id: 'r2', kind: 'rule', rule: ['DNS', 'Т-Банк', 'Расход', 'Спорт', '', ''] }] });
  const cells = g.sheets['Правила импорта'].cells, i = cells.findIndex(r => r[0] === 'Общие правила');
  assert.deepEqual(cells[i - 2].slice(0, 2), ['DNS', 'Т-Банк']);
  assert.equal(cells[i - 1].length, 0, 'пустая строка осталась');
  assert.equal(cells.filter(r => r[0] === 'DNS').length, 1, 'правило не дублируется');
  assert.ok(E.parseRules(call('pull').rules).some(r => r.patterns.includes('dns')));
});
