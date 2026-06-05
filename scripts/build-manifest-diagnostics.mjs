import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist", "fnos");
const fnpack = path.join(root, "tools", "fnpack-user.exe");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r?\n/g, "\n"), "utf8");
}

function replaceInFile(file, replacements) {
  let content = read(file);
  for (const [from, to] of replacements) content = content.replaceAll(from, to);
  write(file, content);
}

function buildAndFix(src, outputName) {
  run(fnpack, ["build", "-d", src]);
  const raw = path.join(root, "dockermanager.fpk");
  const rawOut = path.join(dist, `${outputName}-raw.fpk`);
  const fixedOut = path.join(dist, `${outputName}.fpk`);
  fs.copyFileSync(raw, rawOut);
  run(process.execPath, [path.join(root, "scripts", "fix-fpk-modes.mjs"), rawOut, fixedOut]);
  console.log(`Built ${fixedOut}`);
}

function createProbe(name, mutate) {
  const parent = path.join(dist, `manifest-probe-${name}`);
  const app = path.join(parent, "App.Native.ProbeInstall");
  reset(parent);
  run(fnpack, ["create", "App.Native.ProbeInstall"], parent);
  mutate(app);
  buildAndFix(app, `ManifestProbe-${name}`);
}

createProbe("dockermanager-name", (app) => {
  replaceInFile(path.join(app, "manifest"), [
    ["App.Native.ProbeInstall", "dockermanager"],
    ["display-name", "dockermanager"],
    ["app-description", "dockermanager"],
  ]);
  replaceInFile(path.join(app, "app", "ui", "config"), [
    ["App.Native.ProbeInstall.Application", "dockermanager.Application"],
    ["App.Native.ProbeInstall", "dockermanager"],
  ]);
  replaceInFile(path.join(app, "config", "resource"), [
    ["App.Native.ProbeInstall", "dockermanager"],
  ]);
});

createProbe("dockermanager-platform", (app) => {
  replaceInFile(path.join(app, "manifest"), [
    ["App.Native.ProbeInstall", "dockermanager"],
    ["display-name", "dockermanager"],
    ["app-description", "dockermanager"],
    ["arch                  = x86_64", "platform              = x86\narch                  = x86_64"],
    ["desktop_applaunchname = dockermanager.Application", "desktop_applaunchname = dockermanager.Application\ncheckport             = false"],
  ]);
  replaceInFile(path.join(app, "app", "ui", "config"), [
    ["App.Native.ProbeInstall.Application", "dockermanager.Application"],
    ["App.Native.ProbeInstall", "dockermanager"],
  ]);
  replaceInFile(path.join(app, "config", "resource"), [
    ["App.Native.ProbeInstall", "dockermanager"],
  ]);
});

createProbe("docker-manager-meta", (app) => {
  replaceInFile(path.join(app, "manifest"), [
    ["App.Native.ProbeInstall", "dockermanager"],
    ["version               = 1.0.0", "version               = 0.1.5"],
    ["display-name", "Docker Manager"],
    ["app-description", "Docker container startup order and monitoring manager"],
    ["your-name", "YM040923"],
  ]);
  replaceInFile(path.join(app, "app", "ui", "config"), [
    ["App.Native.ProbeInstall.Application", "dockermanager.Application"],
    ["App.Native.ProbeInstall", "Docker Manager"],
  ]);
  replaceInFile(path.join(app, "config", "resource"), [
    ["App.Native.ProbeInstall", "dockermanager"],
  ]);
});

run(process.execPath, [path.join(root, "scripts", "prepare-runtime-native.mjs")]);
run(process.execPath, [path.join(root, "scripts", "prepare-fnpack-source.mjs")]);
const templateManifestSource = path.join(dist, "fnpack-src-template-manifest");
reset(templateManifestSource);
copyDir(path.join(dist, "fnpack-src"), templateManifestSource);
const manifestPath = path.join(templateManifestSource, "manifest");
const templateManifest = read(manifestPath)
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("platform") && !line.startsWith("checkport"))
  .join("\n");
write(manifestPath, templateManifest);
buildAndFix(templateManifestSource, "DockerManager-0.1.4-template-manifest");
