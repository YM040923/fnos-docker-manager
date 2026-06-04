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

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.replace(/\r?\n/g, "\n"), "utf8");
}

reset(webOut);
copyFile(path.join(root, "src", "web", "index.html"), path.join(webOut, "index.html"));
copyFile(path.join(root, "src", "web", "styles.css"), path.join(webOut, "styles.css"));
copyFile(path.join(root, "src", "web", "app.js"), path.join(webOut, "app.js"));

reset(runtime);
fs.mkdirSync(path.join(runtime, "server"), { recursive: true });
fs.mkdirSync(path.join(runtime, "shared"), { recursive: true });
fs.mkdirSync(path.join(runtime, "web"), { recursive: true });
fs.mkdirSync(path.join(runtime, "ui", "images"), { recursive: true });
fs.mkdirSync(path.join(runtime, "scripts"), { recursive: true });
fs.mkdirSync(path.join(runtime, "config"), { recursive: true });

copyDir(path.join(root, "src", "server"), path.join(runtime, "server"), (source, entry) => {
  return !entry.isFile() || !source.endsWith(".test.js");
});
copyDir(path.join(root, "src", "shared"), path.join(runtime, "shared"));
copyDir(webOut, path.join(runtime, "web"));
copyFile(path.join(root, "package.json"), path.join(runtime, "package.json"));
copyFile(path.join(root, "packaging", "fnos", "app", "ui", "config"), path.join(runtime, "ui", "config"));
copyFile(path.join(root, "packaging", "fnos", "app", "config", "env.example"), path.join(runtime, "config", "env.example"));
copyFile(path.join(root, "packaging", "fnos", "app", "README.md"), path.join(runtime, "README.md"));

const iconResult = spawnSync(process.execPath, [path.join(root, "scripts", "generate-icons.mjs"), path.join(runtime, "ui", "images")], {
  stdio: "inherit",
});
if (iconResult.status !== 0) {
  throw new Error("generate-icons failed");
}

writeExecutable(
  path.join(runtime, "scripts", "start.sh"),
  `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/server/index.js"
`,
);
writeExecutable(
  path.join(runtime, "scripts", "stop.sh"),
  `#!/usr/bin/env bash
set -euo pipefail
echo "Stop is controlled by fnOS cmd/main"
`,
);
writeExecutable(
  path.join(runtime, "scripts", "status.sh"),
  `#!/usr/bin/env bash
set -euo pipefail
echo "Status is controlled by fnOS cmd/main"
`,
);

console.log(`Prepared runtime at ${runtime}`);

