import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const input = process.argv[2] || path.join(root, "dockermanager.fpk");
const output =
  process.argv[3] || path.join(root, "dist", "fnos", "DockerManager-fixed-x86_64.fpk");

function parseOctal(buffer, start, length) {
  const text = buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/, "")
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parseTarGz(fileOrBuffer) {
  const source = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const data = zlib.gunzipSync(source);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseOctal(header, 124, 12);
    const mode = parseOctal(header, 100, 8);
    const type = header.subarray(156, 157).toString("utf8") || "0";
    const body = data.subarray(offset, offset + size);
    offset += size + ((512 - (size % 512)) % 512);
    entries.push({ name, size, mode, type, body: Buffer.from(body) });
  }
  return entries;
}

function writeString(buffer, offset, length, value) {
  Buffer.from(value).copy(buffer, offset, 0, Math.min(length, Buffer.byteLength(value)));
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length - 1, text);
  buffer[offset + length - 1] = 0;
}

function tarHeader(name, size, mode, type) {
  const buffer = Buffer.alloc(512, 0);
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path too long: ${name}`);
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
  writeString(buffer, 148, 6, sum.toString(8).padStart(6, "0"));
  buffer[154] = 0;
  buffer[155] = 0x20;
  return buffer;
}

function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const type = entry.type || "0";
    const body = type === "5" ? Buffer.alloc(0) : entry.body;
    chunks.push(tarHeader(entry.name, body.length, entry.mode, type));
    if (body.length) {
      chunks.push(body);
      const padding = (512 - (body.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function isTopExecutable(name) {
  return name.startsWith("cmd/") && name !== "cmd/";
}

function isAppExecutable(name) {
  return name === "bin/docker-manager" || name.startsWith("scripts/") || name.endsWith(".sh");
}

function normalizeModes(entries, executablePredicate) {
  for (const entry of entries) {
    const clean = entry.name.replace(/\/$/, "");
    if (entry.type === "5" || entry.name.endsWith("/")) {
      entry.mode = 0o755;
      entry.type = "5";
    } else if (executablePredicate(clean)) {
      entry.mode = 0o755;
    } else {
      entry.mode = 0o644;
    }
  }
}

const topEntries = parseTarGz(input);
const appEntry = topEntries.find((entry) => entry.name === "app.tgz");
const manifestEntry = topEntries.find((entry) => entry.name === "manifest");
if (!appEntry) throw new Error("Missing app.tgz");
if (!manifestEntry) throw new Error("Missing manifest");

const appEntries = parseTarGz(appEntry.body);
normalizeModes(appEntries, isAppExecutable);
appEntry.body = tarGz(appEntries);
appEntry.size = appEntry.body.length;

const checksum = crypto.createHash("md5").update(appEntry.body).digest("hex");
const manifest = manifestEntry.body
  .toString("utf8")
  .replace(/checksum\s*=.*(?:\r?\n)?/g, "")
  .trimEnd();
manifestEntry.body = Buffer.from(`${manifest}\nchecksum              = ${checksum}\n`, "utf8");
manifestEntry.size = manifestEntry.body.length;

normalizeModes(topEntries, isTopExecutable);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, tarGz(topEntries));
console.log(`Fixed fpk modes: ${output}`);
