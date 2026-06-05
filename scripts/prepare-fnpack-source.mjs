import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const templateDir = path.join(root, "packaging", "fnos");
const runtimeDir = path.join(root, "dist", "fnos", "runtime");
const outDir = path.join(root, "dist", "fnos", "fnpack-src");

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

if (!fs.existsSync(runtimeDir)) {
  throw new Error(`Missing runtime: ${runtimeDir}. Run npm run prepare:fnos:native first.`);
}

reset(outDir);
copyDir(templateDir, outDir);
fs.rmSync(path.join(outDir, "build-fpk.sh"), { force: true });
fs.rmSync(path.join(outDir, "app"), { recursive: true, force: true });
copyDir(runtimeDir, path.join(outDir, "app"));

const manifestPath = path.join(outDir, "manifest");
const manifest = fs.readFileSync(manifestPath, "utf8").replace("__VERSION__", pkg.version);
fs.writeFileSync(manifestPath, manifest.replace(/\r?\n/g, "\n"), "utf8");

copyFile(path.join(runtimeDir, "ui", "images", "icon_64.png"), path.join(outDir, "ICON.PNG"));
copyFile(path.join(runtimeDir, "ui", "images", "icon_256.png"), path.join(outDir, "ICON_256.PNG"));

console.log(`Prepared fnpack source at ${outDir}`);
