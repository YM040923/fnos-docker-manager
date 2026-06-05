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

function rgba(hex, alpha = 255) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    alpha,
  ];
}

function blend(data, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const offset = (y * width + x) * 4;
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  data[offset] = Math.round(color[0] * alpha + data[offset] * inverse);
  data[offset + 1] = Math.round(color[1] * alpha + data[offset + 1] * inverse);
  data[offset + 2] = Math.round(color[2] * alpha + data[offset + 2] * inverse);
  data[offset + 3] = Math.round(255 * alpha + data[offset + 3] * inverse);
}

function inRoundedRect(px, py, x, y, w, h, r) {
  const qx = Math.max(x - px, 0, px - (x + w));
  const qy = Math.max(y - py, 0, py - (y + h));
  if (qx === 0 && qy === 0) {
    const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
    const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
    return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2 || (px >= x + r && px <= x + w - r) || (py >= y + r && py <= y + h - r);
  }
  return false;
}

function drawRoundedRect(data, width, scale, x, y, w, h, r, color) {
  const sx = Math.floor(x * scale);
  const sy = Math.floor(y * scale);
  const ex = Math.ceil((x + w) * scale);
  const ey = Math.ceil((y + h) * scale);
  for (let py = sy; py < ey; py += 1) {
    for (let px = sx; px < ex; px += 1) {
      if (inRoundedRect(px / scale, py / scale, x, y, w, h, r)) blend(data, width, px, py, color);
    }
  }
}

function drawCircle(data, width, scale, cx, cy, radius, color) {
  const sx = Math.floor((cx - radius) * scale);
  const sy = Math.floor((cy - radius) * scale);
  const ex = Math.ceil((cx + radius) * scale);
  const ey = Math.ceil((cy + radius) * scale);
  for (let py = sy; py < ey; py += 1) {
    for (let px = sx; px < ex; px += 1) {
      if ((px / scale - cx) ** 2 + (py / scale - cy) ** 2 <= radius ** 2) blend(data, width, px, py, color);
    }
  }
}

function drawTriangle(data, width, scale, points, color) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.floor(Math.min(...xs) * scale);
  const maxX = Math.ceil(Math.max(...xs) * scale);
  const minY = Math.floor(Math.min(...ys) * scale);
  const maxY = Math.ceil(Math.max(...ys) * scale);
  const area = edge(points[0], points[1], points[2]);
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const point = [px / scale, py / scale];
      const a = edge(point, points[1], points[2]);
      const b = edge(points[0], point, points[2]);
      const c = edge(points[0], points[1], point);
      if ((a >= 0 && b >= 0 && c >= 0 && area >= 0) || (a <= 0 && b <= 0 && c <= 0 && area <= 0)) {
        blend(data, width, px, py, color);
      }
    }
  }
}

function edge(a, b, c) {
  return (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
}

function makeIcon(size) {
  const scale = 4;
  const hi = size * scale;
  const data = Buffer.alloc(hi * hi * 4);

  drawRoundedRect(data, hi, scale, 10, 10, 236, 236, 42, rgba("#0f172a", 255));
  drawRoundedRect(data, hi, scale, 16, 16, 224, 224, 36, rgba("#123f4d", 210));
  drawRoundedRect(data, hi, scale, 24, 24, 208, 102, 26, rgba("#0f766e", 150));
  drawRoundedRect(data, hi, scale, 32, 32, 92, 28, 14, rgba("#ffffff", 30));

  const shadow = rgba("#020617", 90);
  const stack = rgba("#ecfeff", 245);
  const stackAccent = rgba("#67e8f9", 255);
  for (const y of [72, 112, 152]) {
    drawRoundedRect(data, hi, scale, 48, y + 5, 130, 30, 9, shadow);
    drawRoundedRect(data, hi, scale, 44, y, 132, 31, 9, stack);
    drawRoundedRect(data, hi, scale, 56, y + 9, 66, 5, 2, rgba("#0f766e", 205));
    drawRoundedRect(data, hi, scale, 56, y + 18, 46, 4, 2, rgba("#64748b", 145));
    drawCircle(data, hi, scale, 154, y + 15.5, 6, stackAccent);
  }

  drawRoundedRect(data, hi, scale, 190, 73, 7, 94, 4, rgba("#99f6e4", 230));
  drawTriangle(
    data,
    hi,
    scale,
    [
      [193.5, 184],
      [181, 164],
      [206, 164],
    ],
    rgba("#99f6e4", 230),
  );
  for (const y of [82, 122, 162]) {
    drawCircle(data, hi, scale, 193.5, y, 12, rgba("#0f172a", 255));
    drawCircle(data, hi, scale, 193.5, y, 7, rgba("#99f6e4", 255));
  }

  drawCircle(data, hi, scale, 188, 194, 25, rgba("#022c22", 235));
  drawCircle(data, hi, scale, 188, 194, 15, rgba("#22c55e", 255));
  drawCircle(data, hi, scale, 183, 188, 4, rgba("#ffffff", 160));

  return encodePng(downsample(data, size, scale), size);
}

function downsample(source, size, scale) {
  const hi = size * scale;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let yy = 0; yy < scale; yy += 1) {
        for (let xx = 0; xx < scale; xx += 1) {
          const offset = ((y * scale + yy) * hi + x * scale + xx) * 4;
          totals[0] += source[offset];
          totals[1] += source[offset + 1];
          totals[2] += source[offset + 2];
          totals[3] += source[offset + 3];
        }
      }
      const outOffset = (y * size + x) * 4;
      const count = scale * scale;
      out[outOffset] = Math.round(totals[0] / count);
      out[outOffset + 1] = Math.round(totals[1] / count);
      out[outOffset + 2] = Math.round(totals[2] / count);
      out[outOffset + 3] = Math.round(totals[3] / count);
    }
  }
  return out;
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4)]));
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
fs.writeFileSync(path.join(out, "icon_64.png"), makeIcon(64));
fs.writeFileSync(path.join(out, "icon_256.png"), makeIcon(256));
