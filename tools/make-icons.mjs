// Рисует значок (три столбика) в PNG без зависимостей: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = buf => { let c = ~0; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data){
  const t = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(t));
  return Buffer.concat([len, t, sum]);
}
// столбики в квадрате 0..1: [x0, y0, x1, y1]
const SHAPES = [[.22, .54, .36, .76], [.43, .38, .57, .76], [.64, .24, .78, .76]];
const inside = (x, y) => SHAPES.some(r => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
function png(size){
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++){
    const o = y * (size * 3 + 1);
    for (let x = 0; x < size; x++){
      const hit = inside((x + .5) / size, (y + .5) / size), p = o + 1 + x * 3;
      rows[p] = hit ? 255 : 0x00; rows[p + 1] = hit ? 255 : 0x84; rows[p + 2] = hit ? 255 : 0x6f;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(new URL('../app/icons/', import.meta.url), { recursive: true });
for (const size of [180, 192, 512]) writeFileSync(new URL(`../app/icons/icon-${size}.png`, import.meta.url), png(size));
