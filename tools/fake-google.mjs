// Настоящий gas/Code.gs на поддельных сервисах Google, в памяти. Нужен стенду и тестам, в сеть ничего не уходит.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const TOKEN = 'dev-token';
const MAX_ROWS = 1000;

export function makeGoogle(seed){
  const sheets = {};
  const context = vm.createContext({});
  const VDate = vm.runInContext('Date', context);
  const toDate = n => new VDate(Date.UTC(1899, 11, 30) + n * 864e5);

  function fakeSheet(name, cells = []){
    const dated = name === 'Операции';
    let maxRows = Math.max(MAX_ROWS, cells.length);
    const read = (r, c) => {
      const v = cells[r - 1] && cells[r - 1][c - 1];
      if (v === undefined || v === null) return '';
      return dated && c === 1 && r > 1 && typeof v === 'number' ? toDate(v) : v;
    };
    return {
      cells,
      getMaxRows: () => maxRows,
      getLastRow(){
        for (let i = cells.length; i > 0; i--) if (cells[i - 1] && cells[i - 1].some(x => x !== '' && x != null)) return i;
        return 0;
      },
      insertRowsAfter(_, n){ maxRows += n; },
      insertRowBefore(r){ cells.splice(r - 1, 0, []); maxRows++; },
      deleteRow(r){ cells.splice(r - 1, 1); maxRows--; },
      getRange(r, c, nr = 1, nc = 1){
        if (typeof r === 'string') return { setNumberFormat(){} };
        return {
          setNumberFormat(){},
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => read(r + i, c + j))),
          setValues(v){
            v.forEach((row, i) => {
              cells[r - 1 + i] = cells[r - 1 + i] || [];
              row.forEach((x, j) => { cells[r - 1 + i][c - 1 + j] = x; });
            });
          },
          sort({ column }){
            const part = cells.slice(r - 1, r - 1 + nr).map((x, i) => [x, i]);
            part.sort((a, b) => (a[0][column - 1] - b[0][column - 1]) || a[1] - b[1]);
            part.forEach(([x], i) => { cells[r - 1 + i] = x; });
          }
        };
      }
    };
  }
  for (const [name, cells] of Object.entries(seed)) sheets[name] = fakeSheet(name, cells);

  Object.assign(context, {
    Logger: { log: m => console.log(m) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => TOKEN, setProperty(){} }) },
    LockService: { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType(){ return this; } }) },
    SpreadsheetApp: {
      getActive: () => ({
        getSpreadsheetTimeZone: () => 'UTC',
        getSheetByName: n => sheets[n] || null,
        insertSheet: n => (sheets[n] = fakeSheet(n))
      })
    },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: d => d.toISOString().slice(0, 10) }
  });
  vm.runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), context);
  vm.runInContext('setup()', context);
  return {
    sheets,
    call(body){
      context.__e = { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } };
      return vm.runInContext('doPost(__e)', context).text;
    }
  };
}

export const serial = iso => (Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5;
