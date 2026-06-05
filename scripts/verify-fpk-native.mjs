import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fpk = process.argv[2] || path.join(root, "dist", "fnos", `DockerManager-${pkg.version}-native-x86_64.fpk`);

function parseOctal(buffer, start, length) {
  const text = buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/, "")
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parseTarGz(file) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  const entries = new Map();
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
    entries.set(name.replace(/\/$/, ""), { name, size, mode, type, body });
  }
  return entries;
}

function requireEntry(entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Missing entry: ${name}`);
  return entry;
}

function requireExecutable(entries, name) {
  const entry = requireEntry(entries, name);
  if ((entry.mode & 0o111) === 0) {
    throw new Error(`Entry is not executable: ${name}`);
  }
}

function text(entry) {
  return entry.body.toString("utf8");
}

const top = parseTarGz(fpk);
for (const name of [
  "manifest",
  "app.tgz",
  "cmd",
  "config/privilege",
  "config",
  "config/resource",
  "wizard",
  "cmd/main",
  "cmd/install_init",
  "cmd/install_callback",
  "cmd/uninstall_init",
  "cmd/uninstall_callback",
  "cmd/upgrade_init",
  "cmd/upgrade_callback",
  "cmd/config_init",
  "cmd/config_callback",
  "ICON.PNG",
  "ICON_256.PNG",
]) {
  requireEntry(top, name);
}

for (const name of [
  "cmd/main",
  "cmd/install_init",
  "cmd/install_callback",
  "cmd/uninstall_init",
  "cmd/uninstall_callback",
  "cmd/upgrade_init",
  "cmd/upgrade_callback",
  "cmd/config_init",
  "cmd/config_callback",
]) {
  requireExecutable(top, name);
}

const manifest = text(requireEntry(top, "manifest"));
for (const expected of [
  "appname               = dockermanager",
  `version               = ${pkg.version}`,
  "arch                  = x86_64",
  "desktop_applaunchname = dockermanager.Application",
]) {
  if (!manifest.includes(expected)) throw new Error(`Manifest missing: ${expected}`);
}
if (manifest.includes("install_type")) throw new Error("Manifest must not contain install_type");
if (manifest.includes("platform              = x86")) throw new Error("Manifest must not force platform x86");
if (manifest.includes("checkport             = false")) throw new Error("Manifest must not contain checkport false");

JSON.parse(text(requireEntry(top, "config/privilege")));
JSON.parse(text(requireEntry(top, "config/resource")));

const appTgzPath = path.join(path.dirname(fpk), ".verify-app.tgz");
fs.writeFileSync(appTgzPath, requireEntry(top, "app.tgz").body);
try {
  const app = parseTarGz(appTgzPath);
  for (const name of [
    "server",
    "server/docker-manager",
    "ui",
    "ui/config",
    "ui/images/icon_64.png",
    "ui/images/icon_256.png",
    "www",
    "www/index.html",
    "www/styles.css",
    "www/app.js",
  ]) {
    requireEntry(app, name);
  }
  requireExecutable(app, "server/docker-manager");
  const uiConfig = JSON.parse(text(requireEntry(app, "ui/config")));
  const entry = uiConfig[".url"]?.["dockermanager.Application"];
  if (!entry) throw new Error("UI config missing dockermanager.Application");
  if (entry.gatewaySocket !== "app.sock") throw new Error("UI config gatewaySocket must be app.sock");
  if (entry.gatewayPrefix !== "/app/dockermanager") throw new Error("UI config gatewayPrefix must be /app/dockermanager");
} finally {
  fs.rmSync(appTgzPath, { force: true });
}

console.log(`Native fpk verified: ${fpk}`);
