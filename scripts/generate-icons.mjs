import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(root, "assets", "fnos-icons");
const out = process.argv[2];

function requirePngSize(file, width, height = width) {
  const data = fs.readFileSync(file);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!data.subarray(0, 8).equals(signature)) {
    throw new Error(`${file} is not a PNG file`);
  }
  const actualWidth = data.readUInt32BE(16);
  const actualHeight = data.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${file} must be ${width}x${height}, got ${actualWidth}x${actualHeight}`);
  }
}

function copyIcon(name, width) {
  const source = path.join(sourceDir, name);
  requirePngSize(source, width);
  fs.copyFileSync(source, path.join(out, name));
}

function copyAlias(sourceName, targetName, width) {
  const source = path.join(sourceDir, sourceName);
  requirePngSize(source, width);
  fs.copyFileSync(source, path.join(out, targetName));
}

if (!out) throw new Error("Usage: node scripts/generate-icons.mjs <output-dir>");
fs.mkdirSync(out, { recursive: true });

copyIcon("icon_64.png", 64);
copyIcon("icon_256.png", 256);
copyIcon("icon.png", 256);
copyAlias("icon_64.png", "docker-manager-3d_64.png", 64);
copyAlias("icon_256.png", "docker-manager-3d_256.png", 256);
copyAlias("icon.png", "docker-manager-3d.png", 256);
