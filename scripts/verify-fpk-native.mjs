import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fpk = process.argv[2] || path.join(root, "dist", "fnos", `DockerStart-${pkg.version}-native-x86_64.fpk`);

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

function hash(entry) {
  return crypto.createHash("sha256").update(entry.body).digest("hex");
}

function requirePngSize(entries, name, width, height = width) {
  const entry = requireEntry(entries, name);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!entry.body.subarray(0, 8).equals(signature)) {
    throw new Error(`${name} is not a PNG file`);
  }
  const actualWidth = entry.body.readUInt32BE(16);
  const actualHeight = entry.body.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${name} must be ${width}x${height}, got ${actualWidth}x${actualHeight}`);
  }
  return entry;
}

function requireOpaqueRgbPng(entry, name) {
  const colorType = entry.body[25];
  if (colorType !== 2) {
    throw new Error(`${name} must be an opaque RGB PNG without transparent corners, got color type ${colorType}`);
  }
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
  "cmd/icon_sync",
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
  "cmd/icon_sync",
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
  "appname               = dockerstart",
  `version               = ${pkg.version}`,
  "arch                  = x86_64",
  "desktop_applaunchname = dockerstart.Application",
]) {
  if (!manifest.includes(expected)) throw new Error(`Manifest missing: ${expected}`);
}
if (manifest.includes("install_type")) throw new Error("Manifest must not contain install_type");
if (manifest.includes("platform              = x86")) throw new Error("Manifest must not force platform x86");
if (manifest.includes("checkport             = false")) throw new Error("Manifest must not contain checkport false");

JSON.parse(text(requireEntry(top, "config/privilege")));
JSON.parse(text(requireEntry(top, "config/resource")));

const installInit = text(requireEntry(top, "cmd/install_init"));
for (const expected of ["app.pid", "kill -TERM", "app.sock"]) {
  if (!installInit.includes(expected)) throw new Error(`install_init missing stale runtime cleanup: ${expected}`);
}

const mainScript = text(requireEntry(top, "cmd/main"));
for (const expected of [
  "install_autostart()",
  "remove_autostart()",
  "WantedBy=multi-user.target",
  "After=network-online.target docker.service",
  'systemctl enable "$SERVICE_NAME"',
  "TRIM_TEMP_LOGFILE",
]) {
  if (!mainScript.includes(expected)) throw new Error(`cmd/main missing boot autostart support: ${expected}`);
}
if (mainScript.includes('systemctl enable "$SERVICE_NAME" || true')) {
  throw new Error("cmd/main must not silently ignore boot autostart enable failures");
}

const installCallback = text(requireEntry(top, "cmd/install_callback"));
for (const expected of ['main" install-autostart', 'main" start', 'tar -xzf "$pkg_dir/app.tgz" -C "$app_dest"']) {
  if (!installCallback.includes(expected)) throw new Error(`install_callback missing startup handling: ${expected}`);
}

const iconSync = text(requireEntry(top, "cmd/icon_sync"));
for (const expected of ["sync_cached_icon_files()", "dockerstart.Application", "dockermanager.Application", "dockermanager.Manager"]) {
  if (!iconSync.includes(expected)) throw new Error(`icon_sync missing cache refresh handling: ${expected}`);
}

const upgradeInit = text(requireEntry(top, "cmd/upgrade_init"));
for (const expected of ["restart-after-upgrade", "kill -TERM", "app.sock"]) {
  if (!upgradeInit.includes(expected)) throw new Error(`upgrade_init missing restart cleanup: ${expected}`);
}

const upgradeCallback = text(requireEntry(top, "cmd/upgrade_callback"));
for (const expected of [
  "restart-after-upgrade",
  "/main\" install-autostart",
  "/main\" start",
  'tar -xzf "$pkg_dir/app.tgz" -C "$app_dest"',
]) {
  if (!upgradeCallback.includes(expected)) throw new Error(`upgrade_callback missing restart handling: ${expected}`);
}

const uninstallInit = text(requireEntry(top, "cmd/uninstall_init"));
for (const expected of ['main" stop', 'main" remove-autostart']) {
  if (!uninstallInit.includes(expected)) throw new Error(`uninstall_init missing service cleanup: ${expected}`);
}

const rootIcon64 = requirePngSize(top, "ICON.PNG", 64);
const rootIcon256 = requirePngSize(top, "ICON_256.PNG", 256);
requireOpaqueRgbPng(rootIcon64, "ICON.PNG");
requireOpaqueRgbPng(rootIcon256, "ICON_256.PNG");
const expectedIcon64 = { body: fs.readFileSync(path.join(root, "assets", "fnos-icons", "icon_64.png")) };
const expectedIcon256 = { body: fs.readFileSync(path.join(root, "assets", "fnos-icons", "icon_256.png")) };
if (hash(rootIcon64) !== hash(expectedIcon64)) {
  throw new Error("ICON.PNG does not match assets/fnos-icons/icon_64.png");
}
if (hash(rootIcon256) !== hash(expectedIcon256)) {
  throw new Error("ICON_256.PNG does not match assets/fnos-icons/icon_256.png");
}

const appTgzPath = path.join(path.dirname(fpk), ".verify-app.tgz");
fs.writeFileSync(appTgzPath, requireEntry(top, "app.tgz").body);
try {
  const app = parseTarGz(appTgzPath);
  for (const name of [
    "server",
    "server/docker-manager",
    "ui",
    "ui/config",
    "ui/images/icon.png",
    "ui/images/icon_64.png",
    "ui/images/icon_256.png",
    "ui/images/docker-manager-3d.png",
    "ui/images/docker-manager-3d_64.png",
    "ui/images/docker-manager-3d_256.png",
    "www",
    "www/index.html",
    "www/styles.css",
    "www/theme.css",
    "www/app.js",
    "www/container-policy.js",
    "www/selection-order.js",
    "www/ui-components.js",
    "www/images/icon.png",
    "www/images/icon_64.png",
    "www/images/icon_256.png",
    "www/images/docker-manager-3d.png",
    "www/images/docker-manager-3d_64.png",
    "www/images/docker-manager-3d_256.png",
  ]) {
    requireEntry(app, name);
  }
  requireExecutable(app, "server/docker-manager");
  const uiIcon64 = requirePngSize(app, "ui/images/icon_64.png", 64);
  const uiIcon256 = requirePngSize(app, "ui/images/icon_256.png", 256);
  const uiIcon = requirePngSize(app, "ui/images/icon.png", 256);
  const webIcon64 = requirePngSize(app, "www/images/icon_64.png", 64);
  const webIcon256 = requirePngSize(app, "www/images/icon_256.png", 256);
  const webIcon = requirePngSize(app, "www/images/icon.png", 256);
  const entryIcon64 = requirePngSize(app, "ui/images/docker-manager-3d_64.png", 64);
  const entryIcon256 = requirePngSize(app, "ui/images/docker-manager-3d_256.png", 256);
  const entryIcon = requirePngSize(app, "ui/images/docker-manager-3d.png", 256);
  const webEntryIcon64 = requirePngSize(app, "www/images/docker-manager-3d_64.png", 64);
  const webEntryIcon256 = requirePngSize(app, "www/images/docker-manager-3d_256.png", 256);
  const webEntryIcon = requirePngSize(app, "www/images/docker-manager-3d.png", 256);
  if (hash(rootIcon64) !== hash(uiIcon64) || hash(rootIcon64) !== hash(webIcon64) || hash(rootIcon64) !== hash(entryIcon64) || hash(rootIcon64) !== hash(webEntryIcon64)) {
    throw new Error("64px app icons are not identical across package, UI entry, and web assets");
  }
  if (hash(rootIcon256) !== hash(uiIcon256) || hash(rootIcon256) !== hash(webIcon256) || hash(rootIcon256) !== hash(uiIcon) || hash(rootIcon256) !== hash(webIcon) || hash(rootIcon256) !== hash(entryIcon256) || hash(rootIcon256) !== hash(entryIcon) || hash(rootIcon256) !== hash(webEntryIcon256) || hash(rootIcon256) !== hash(webEntryIcon)) {
    throw new Error("256px app icons are not identical across package, UI entry, and web assets");
  }
  const uiConfig = JSON.parse(text(requireEntry(app, "ui/config")));
  const entry = uiConfig[".url"]?.["dockerstart.Application"];
  if (!entry) throw new Error("UI config missing dockerstart.Application");
  if (uiConfig[".url"]?.["dockerstart.Manager"]) throw new Error("UI config must not keep stale dockerstart.Manager entry");
  if (entry.icon !== "images/docker-manager-3d_{0}.png") throw new Error("UI config icon must use the cache-busting icon filename");
  if (entry.gatewaySocket !== "app.sock") throw new Error("UI config gatewaySocket must be app.sock");
  if (entry.gatewayPrefix !== "/app/dockerstart") throw new Error("UI config gatewayPrefix must be /app/dockerstart");
  const indexHtml = text(requireEntry(app, "www/index.html"));
  for (const expected of [
    'data-view="dashboard" aria-current="page"',
    `images/docker-manager-3d_64.png?v=${pkg.version}`,
    `styles.css?v=${pkg.version}`,
    `theme.css?v=${pkg.version}`,
    `app.js?v=${pkg.version}`,
    `v${pkg.version}`,
  ]) {
    if (!indexHtml.includes(expected)) throw new Error(`www/index.html missing cache/version marker: ${expected}`);
  }
  const themeCss = text(requireEntry(app, "www/theme.css"));
  for (const expected of [
    "transition: none !important",
    '.nav .nav-item[aria-current="page"]',
    '.nav-item:not(.active):not([aria-current="page"]):hover',
    "--bg: #f3f4f6",
    "background: var(--bg)",
    "--selected-bg",
    "--status-ok-bg",
    "--dot-ok",
    "--radius-lg: 18px",
    "border-right: 0",
    '.select-card[data-selected="true"]',
    '.status::before',
    'content: "✓"',
  ]) {
    if (!themeCss.includes(expected)) throw new Error(`www/theme.css missing nav state hardening: ${expected}`);
  }
  if (/#16a34a|#dc2626|#c08400|#7c3aed|#0f766e/i.test(themeCss)) {
    throw new Error("www/theme.css must keep the app palette neutral");
  }
  const appJs = text(requireEntry(app, "www/app.js"));
  for (const expected of [
    "已守护",
    "未守护",
    'draggable: mode === "orchestration"',
  ]) {
    if (!appJs.includes(expected)) throw new Error(`www/app.js missing current selection UI marker: ${expected}`);
  }
  if (appJs.includes("个守护")) {
    throw new Error("www/app.js still contains stale guard ordinal label");
  }
  const uiComponentsJs = text(requireEntry(app, "www/ui-components.js"));
  if (!uiComponentsJs.includes('draggable="${draggable ? "true" : "false"}"')) {
    throw new Error("www/ui-components.js must render draggable=false for non-ordered views");
  }
  for (const expected of ['data-selected="${selected ? "true" : "false"}"', 'data-status="${escapeHtml(statusClass)}"']) {
    if (!uiComponentsJs.includes(expected)) throw new Error(`www/ui-components.js missing design-system state attribute: ${expected}`);
  }
} finally {
  fs.rmSync(appTgzPath, { force: true });
}

console.log(`Native fpk verified: ${fpk}`);
