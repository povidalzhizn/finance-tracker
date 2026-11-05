// Стенд: отдаёт app/ под /finance-tracker/, как GitHub Pages, и выполняет настоящий gas/Code.gs на POST /exec.
// Данные выдуманные (tools/seed.mjs). С ключом --private <папка> отдаёт файлы из папки по /__private/ для проверки на своих выписках.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGoogle } from './fake-google.mjs';
import { seed } from './seed.mjs';

const PORT = Number(process.env.PORT || 5198), BASE = '/finance-tracker/';
const APP = fileURLToPath(new URL('../app/', import.meta.url));
const flag = process.argv.indexOf('--private'), PRIVATE = flag > 0 ? process.argv[flag + 1] : null;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const google = makeGoogle(seed());

async function serve(res, root, rel){
  const clean = normalize(rel || 'index.html');
  if (clean.startsWith('..')){ res.writeHead(403); res.end(); return; }
  const path = join(root, clean);
  try {
    if (!(await stat(path)).isFile()) throw 0;
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch (e) { res.writeHead(404); res.end(); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/exec' && req.method === 'POST'){
    let body = ''; for await (const c of req) body += c;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(google.call(body)); return;
  }
  if (url.pathname === '/__sheets'){
    const dump = Object.fromEntries(Object.entries(google.sheets).map(([k, v]) => [k, v.cells]));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(dump)); return;
  }
  if (PRIVATE && url.pathname.startsWith('/__private/')) return serve(res, PRIVATE, decodeURIComponent(url.pathname.slice(11)));
  if (url.pathname === '/'){ res.writeHead(302, { Location: BASE }); res.end(); return; }
  if (!url.pathname.startsWith(BASE)){ res.writeHead(404); res.end(); return; }
  return serve(res, APP, decodeURIComponent(url.pathname.slice(BASE.length)));
}).listen(PORT, () => console.log('http://localhost:' + PORT + BASE));
