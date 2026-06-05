import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, "dist", "fnos", "runtime");
const webOut = path.join(root, "dist", "fnos", "web");

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (!filter(source, entry)) continue;
    if (entry.isDirectory()) copyDir(source, target, filter);
    if (entry.isFile()) copyFile(source, target);
  }
}

reset(webOut);
copyFile(path.join(root, "src", "web", "index.html"), path.join(webOut, "index.html"));
copyFile(path.join(root, "src", "web", "styles.css"), path.join(webOut, "styles.css"));
copyFile(path.join(root, "src", "web", "app.js"), path.join(webOut, "app.js"));

reset(runtime);
fs.mkdirSync(path.join(runtime, "server"), { recursive: true });
fs.mkdirSync(path.join(runtime, "www"), { recursive: true });
fs.mkdirSync(path.join(runtime, "ui", "images"), { recursive: true });

copyDir(webOut, path.join(runtime, "www"));
copyFile(path.join(root, "packaging", "fnos", "app", "ui", "config"), path.join(runtime, "ui", "config"));

const iconResult = spawnSync(process.execPath, [path.join(root, "scripts", "generate-icons.mjs"), path.join(runtime, "ui", "images")], {
  stdio: "inherit",
});
if (iconResult.status !== 0) {
  throw new Error("generate-icons failed");
}

const goExe = process.env.GO_EXE || "C:\\Users\\ymzwh\\FrpPilot\\tools\\go\\bin\\go.exe";
const goResult = spawnSync(goExe, ["build", "-o", path.join(runtime, "server", "docker-manager"), "./cmd/docker-manager"], {
  cwd: root,
  env: {
    ...process.env,
    GOOS: "linux",
    GOARCH: "amd64",
    CGO_ENABLED: "0",
  },
  stdio: "inherit",
});
if (goResult.status !== 0) {
  throw new Error("go build failed");
}
fs.rmSync(path.join(runtime, "ui", "images", "icon.png"), { force: true });

console.log(`Prepared runtime at ${runtime}`);
