import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dist = path.join(root, "dist", "fnos");
const runtime = path.join(dist, "runtime");
const outDir = dist;
const packageName = `DockerStart-${pkg.version}-native-x86_64.fpk`;
const outFile = path.join(outDir, packageName);

function listFiles(dir, base = dir) {
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rows.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      rows.push({
        full,
        rel: path.relative(base, full).replaceAll(path.sep, "/"),
      });
    }
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

function listEntries(dir, base = dir) {
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      rows.push({ full, rel, directory: true });
      rows.push(...listEntries(full, base));
    } else if (entry.isFile()) {
      rows.push({ full, rel });
    }
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

function writeString(buffer, offset, length, value) {
  const text = Buffer.from(value);
  text.copy(buffer, offset, 0, Math.min(length, text.length));
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length - 1, text);
  buffer[offset + length - 1] = 0;
}

function tarHeader(name, size, mode = 0o644, type = "0") {
  const buffer = Buffer.alloc(512, 0);
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Tar path too long: ${name}`);
  }
  writeString(buffer, 0, 100, name);
  writeOctal(buffer, 100, 8, mode);
  writeOctal(buffer, 108, 8, 0);
  writeOctal(buffer, 116, 8, 0);
  writeOctal(buffer, 124, 12, size);
  writeOctal(buffer, 136, 12, Math.floor(Date.now() / 1000));
  buffer.fill(0x20, 148, 156);
  writeString(buffer, 156, 1, type);
  writeString(buffer, 257, 6, "ustar");
  writeString(buffer, 263, 2, "00");
  let sum = 0;
  for (const byte of buffer) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  writeString(buffer, 148, 6, checksum);
  buffer[154] = 0;
  buffer[155] = 0x20;
  return buffer;
}

function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    if (entry.directory) {
      const name = entry.name || entry.rel;
      chunks.push(tarHeader(name.endsWith("/") ? name : `${name}/`, 0, entry.mode ?? 0o755, "5"));
      continue;
    }
    const data = entry.data ?? fs.readFileSync(entry.full);
    const mode = entry.mode ?? (entry.executable ? 0o755 : 0o644);
    chunks.push(tarHeader(entry.name || entry.rel, data.length, mode));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function isExecutableRel(rel) {
  return rel === "server/docker-manager" || rel === "bin/docker-manager" || rel.startsWith("cmd/") || rel.startsWith("scripts/") || rel.endsWith(".sh");
}

function makeAppTgz() {
  const entries = listEntries(runtime).map((file) => ({
    ...file,
    executable: !file.directory && isExecutableRel(file.rel),
  }));
  return tarGz(entries);
}

function makeManifest(checksum) {
  return readText(path.join(root, "packaging", "fnos", "manifest"))
    .replace("__VERSION__", pkg.version)
    .replace(/checksum\s*=.*\n/g, "")
    .trimEnd() + `\nchecksum              = ${checksum}\n`;
}

function main() {
  if (!fs.existsSync(runtime)) {
    throw new Error(`Missing runtime: ${runtime}. Run scripts/prepare-linux-runtime.sh first.`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const appTgz = makeAppTgz();
  const checksum = crypto.createHash("md5").update(appTgz).digest("hex");
  const topEntries = [
    { name: "manifest", data: Buffer.from(makeManifest(checksum), "utf8") },
    { name: "app.tgz", data: appTgz },
  ];
  for (const folder of ["cmd", "config", "wizard"]) {
    topEntries.push({ name: `${folder}/`, directory: true, mode: 0o755 });
    for (const file of listFiles(path.join(root, "packaging", "fnos", folder))) {
      topEntries.push({
        name: `${folder}/${file.rel}`,
        full: file.full,
        executable: folder === "cmd",
      });
    }
  }
  for (const icon of ["ICON.PNG", "ICON_256.PNG"]) {
    const iconName = icon === "ICON.PNG" ? "icon_64.png" : "icon_256.png";
    topEntries.push({
      name: icon,
      full: path.join(runtime, "ui", "images", iconName),
    });
  }
  fs.writeFileSync(outFile, tarGz(topEntries));
  console.log(`Built ${outFile}`);
}

main();
