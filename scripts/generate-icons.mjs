import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makeIcon(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  const scale = size / 256;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const cx = x / scale;
      const cy = y / scale;
      const offset = 1 + x * 4;
      let r = 15;
      let g = 23;
      let b = 42;
      if (cx >= 38 && cx <= 218 && cy >= 54 && cy <= 198) {
        r = 14;
        g = 116;
        b = 144;
      }
      const tileX = (cx >= 66 && cx <= 104) || (cx >= 112 && cx <= 150) || (cx >= 158 && cx <= 196);
      const tileY = (cy >= 84 && cy <= 122) || (cy >= 132 && cy <= 170);
      if (tileX && tileY) {
        r = 240;
        g = 253;
        b = 250;
      }
      if (cy >= 184 && cy <= 194 && cx >= 58 && cx <= 198) {
        r = 8;
        g = 47;
        b = 73;
      }
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/generate-icons.mjs <output-dir>");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), makeIcon(256));
fs.writeFileSync(path.join(out, "icon_64.png"), makeIcon(64));
fs.writeFileSync(path.join(out, "icon_256.png"), makeIcon(256));

